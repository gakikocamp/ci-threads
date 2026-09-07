// 灯守 学習エンジンの中核（純粋関数のみ・DB非依存）
// 設計: threads-app/灯守-実装指示書_v3_2026-09-08.md §7
// 冪等性のため乱数は日付シードの決定的PRNG。同じ日に再実行しても同じレシピが出る。

export const DIMENSIONS = ['pattern', 'hook', 'fact', 'slot', 'format'];

// ── 決定的乱数（mulberry32）──
export function makeRng(seed) {
  let a = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// Box-Muller。rng() が 0 を返すと log(0) になるので下限を入れる
export function sampleNormal(rng, mu, sigma) {
  const u1 = Math.max(rng(), 1e-12), u2 = rng();
  return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ── Welford（オンライン平均・分散）。finalで仮反映を取り消すため remove も持つ ──
export function welfordAdd(s, x) {
  const n = (s.n || 0) + 1;
  const delta = x - (s.mean || 0);
  const mean = (s.mean || 0) + delta / n;
  const m2 = (s.m2 || 0) + delta * (x - mean);
  return { n, mean, m2 };
}
export function welfordRemove(s, x) {
  const n0 = s.n || 0;
  if (n0 <= 1) return { n: 0, mean: 0, m2: 0 };
  const n = n0 - 1;
  const mean = (s.mean * n0 - x) / n;
  const m2 = Math.max(0, s.m2 - (x - mean) * (x - s.mean));
  return { n, mean, m2 };
}

// ── 転換率（プロフィールクリック→フォロー）──
export function computeConv(netGrowth, totalClicks, fallback = 0.3) {
  if (!totalClicks || totalClicks < 50) return fallback;
  return clamp(netGrowth / totalClicks, 0.05, 0.6);
}
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * direct経路の帰属: 日ごとのフォロワー純増を、その日にアクティブな投稿のインプレッション増分で按分する。
 * @param {Object} p
 * @param {Object<string, number>} p.dailyDeltas  {'YYYY-MM-DD': Δfollowers（負は0扱い）}
 * @param {Object<string, Object<string, number>>} p.dailyImpressions {date: {queue_id: その日のインプ増分}}
 * @returns {Object<string, number>} {queue_id: est_follows_direct}
 */
export function attributeDirect({ dailyDeltas, dailyImpressions }) {
  const out = {};
  for (const [date, rawDelta] of Object.entries(dailyDeltas)) {
    const delta = Math.max(0, rawDelta || 0);
    if (!delta) continue;
    const imps = dailyImpressions[date] || {};
    const total = Object.values(imps).reduce((a, b) => a + Math.max(0, b || 0), 0);
    if (total <= 0) continue;
    for (const [qid, imp] of Object.entries(imps)) {
      const share = Math.max(0, imp || 0) / total;
      out[qid] = (out[qid] || 0) + delta * share;
    }
  }
  return out;
}

// 観測値。clicks経路とdirect経路を半々で混ぜる（片方が壊れても全体が壊れない）
export function computeObservation({ profileClicks = 0, conv = 0.3, direct = 0, replies = 0, quotes = 0, reposts = 0, likes = 0, bookmarks = 0 }) {
  const clicksPath = (profileClicks || 0) * conv;
  return {
    est_follows_clicks: clicksPath,
    est_follows_direct: direct,
    est_follows: 0.5 * clicksPath + 0.5 * direct,
    // X公開重み準拠（返信+5・引用+5・リポスト+1・いいね+0.5）。ブックマークは未公開のため2で仮置き
    engagement_score: 5 * replies + 5 * quotes + 1 * reposts + 0.5 * likes + 2 * bookmarks,
  };
}

// ── 事後分布とThompson sampling ──
export function posterior(arm, globalMean) {
  const priorN = arm.prior_n ?? 2;
  const priorMean = arm.prior_mean ?? globalMean;
  const n = arm.n || 0;
  const total = priorN + n;
  const mu = (priorN * priorMean + n * (arm.mean || 0)) / total;
  // 観測が少ないうちは分散を大きめに見積もり、探索が起きやすいようにする
  const varObs = n > 1 ? (arm.m2 || 0) / (n - 1) : 0;
  const sigma2 = Math.max(varObs, 0.25 * globalMean * globalMean) / total;
  return { mu, sigma: Math.sqrt(sigma2) };
}
export function sampleArm(rng, arms, globalMean) {
  let best = null, bestTheta = -Infinity;
  for (const arm of arms) {
    const { mu, sigma } = posterior(arm, globalMean);
    const theta = sampleNormal(rng, mu, sigma);
    if (theta > bestTheta) { bestTheta = theta; best = arm; }
  }
  return best ? { arm: best.arm, theta: bestTheta, ...posterior(best, globalMean) } : null;
}

// ── 制約検査（proven-patterns.md §5 と憲法）──
/**
 * @param {Object} recipe {pattern, hook, fact_ids[], slot, format}
 * @param {Object} ctx {
 *   today, recentPatterns: {pattern: [dates]}, factLastUsed: {fact_id: date},
 *   countsThisWeek: {pattern: n}, countsThisMonth: {pattern: n}, yesterdayPattern, mode
 * }
 */
export function checkConstraints(recipe, ctx) {
  const v = [];
  const blocked = [];  // 違反の原因になった腕。再抽選のたびに候補から外していく
  const { today, factLastUsed = {}, countsThisWeek = {}, countsThisMonth = {}, yesterdayPattern = null, mode = 'buzz' } = ctx;
  const banPattern = (msg) => { v.push(msg); blocked.push({ dimension: 'pattern', arm: recipe.pattern }); };

  if (recipe.pattern === yesterdayPattern) banPattern('同じ型を2日連続で使わない');
  if (recipe.pattern === '数字絶滅型' && (countsThisWeek['数字絶滅型'] || 0) >= 1) banPattern('数字絶滅型は週1本まで');
  if (recipe.pattern === 'そっといいね型' && (countsThisMonth['そっといいね型'] || 0) >= 1) banPattern('そっといいね型は月1本まで');
  if (recipe.pattern === 'お礼' && (countsThisMonth['お礼'] || 0) >= 1) banPattern('お礼は月1本まで');
  if (recipe.format === 'cta' && (countsThisWeek['__cta'] || 0) >= 2) {
    v.push('導線は週2本まで'); blocked.push({ dimension: 'format', arm: 'cta' });
  }

  for (const fid of recipe.fact_ids || []) {
    const last = factLastUsed[fid];
    if (last && daysBetween(last, today) < 14) {
      v.push(`燃料 ${fid} は14日以内に使用済み（${last}）`);
      blocked.push({ dimension: 'fact', arm: fid });
    }
  }
  if (DEAD_PATTERNS.includes(recipe.pattern)) banPattern(`死に型 ${recipe.pattern} は使わない`);

  if (mode === 'safety') {
    if (recipe.pattern !== '安否と事実') banPattern('災害中は安否と事実のみ');
    if ((recipe.fact_ids || []).length > 0) {
      v.push('災害中は燃料（宣伝性のある一次情報）を使わない');
      for (const fid of recipe.fact_ids) blocked.push({ dimension: 'fact', arm: fid });
    }
  }
  return { ok: v.length === 0, violations: v, blocked };
}
export const DEAD_PATTERNS = ['説明分析型', 'フォロー乞い単体', '転身自己紹介'];

export function daysBetween(a, b) {
  const da = Date.parse(`${a}T00:00:00Z`), db = Date.parse(`${b}T00:00:00Z`);
  return Math.round((db - da) / 86400000);
}

// ── 明日のレシピ3本 ──
/**
 * @param {Object} p
 * @param {string} p.date 対象日 'YYYY-MM-DD'
 * @param {Object} p.armsByDim {pattern:[{arm,n,mean,m2,prior_mean,prior_n,last_tried}], hook:[...], fact:[...], slot:[...], format:[...]}
 * @param {Object} p.ctx checkConstraints のコンテキスト
 * @param {number} p.globalMean
 * @param {number} p.explorationDeficit 今週まだ足りない探索本数
 */
export function buildRecipes({ date, armsByDim, ctx, globalMean = 1, explorationDeficit = 0 }) {
  const rng = makeRng(`himori-${date}`);
  const recipes = [];
  const usedPatterns = new Set();

  // 制約で弾かれた腕は以降の抽選から除外する（同じ腕を引き続けて無駄打ちしないため）
  const excluded = { pattern: new Set(), hook: new Set(), fact: new Set(), slot: new Set(), format: new Set() };

  for (let rank = 1; rank <= 3; rank++) {
    const wantExploration = rank === 3 || (rank === 1 && explorationDeficit >= 2);
    let chosen = null, violations = [];

    for (let attempt = 0; attempt < 8 && !chosen; attempt++) {
      const pool = filterArms(armsByDim, excluded, usedPatterns);
      const cand = wantExploration
        ? pickExploration(rng, pool, globalMean)
        : pickExploit(rng, pool, globalMean);
      if (!cand) break;
      const chk = checkConstraints(cand, ctx);
      violations = chk.violations;
      if (chk.ok) chosen = cand;
      else for (const b of chk.blocked) excluded[b.dimension]?.add(b.arm);
    }

    if (!chosen) {
      recipes.push({ rank, date, constraint_ok: 0, is_exploration: wantExploration ? 1 : 0,
        rationale: `制約を満たす組合せを5回で作れなかった: ${violations.join(' / ')}`, violations });
      continue;
    }
    usedPatterns.add(chosen.pattern);
    recipes.push({ ...chosen, rank, date, constraint_ok: 1, is_exploration: wantExploration ? 1 : 0 });
  }
  return recipes;
}

// 除外集合と既出の型を落とした候補プールを作る
function filterArms(armsByDim, excluded, usedPatterns) {
  const out = {};
  for (const dim of DIMENSIONS) {
    out[dim] = (armsByDim[dim] || []).filter((a) => {
      if (excluded[dim]?.has(a.arm)) return false;
      if (dim === 'pattern' && (usedPatterns.has(a.arm) || DEAD_PATTERNS.includes(a.arm))) return false;
      return true;
    });
  }
  return out;
}

function pickExploit(rng, armsByDim, globalMean) {
  const p = sampleArm(rng, armsByDim.pattern || [], globalMean);
  const h = sampleArm(rng, armsByDim.hook || [], globalMean);
  const s = sampleArm(rng, armsByDim.slot || [], globalMean);
  const f = sampleArm(rng, armsByDim.format || [], globalMean);
  const fact = sampleArm(rng, armsByDim.fact || [], globalMean);
  if (!p || !h || !s || !f || !fact) return null;
  return {
    pattern: p.arm, hook: h.arm, slot: s.arm, format: f.arm, fact_ids: [fact.arm],
    rationale: `型「${p.arm}」事後平均${p.mu.toFixed(2)}・フック「${h.arm}」${h.mu.toFixed(2)}・${s.arm}枠${s.mu.toFixed(2)}`,
  };
}

// 探索: 試行回数が少なく、最後に試した日が古い型を優先（14日で一巡させる）
function pickExploration(rng, armsByDim, globalMean) {
  const cands = [...(armsByDim.pattern || [])]
    .sort((a, b) => (a.n || 0) - (b.n || 0) || String(a.last_tried || '').localeCompare(String(b.last_tried || '')));
  const p = cands[0];
  if (!p) return null;
  const h = sampleArm(rng, armsByDim.hook || [], globalMean);
  const s = sampleArm(rng, armsByDim.slot || [], globalMean);
  const f = sampleArm(rng, armsByDim.format || [], globalMean);
  const fact = sampleArm(rng, armsByDim.fact || [], globalMean);
  if (!h || !s || !f || !fact) return null;
  return {
    pattern: p.arm, hook: h.arm, slot: s.arm, format: f.arm, fact_ids: [fact.arm],
    rationale: `探索枠: 型「${p.arm}」は n=${p.n || 0}（最終試行 ${p.last_tried || 'なし'}）。まだ検証できていないので試す`,
  };
}

// ── 学習台帳（人が読む日本語） ──
export function buildLedger({ date, armChanges = [], conv, convBefore, postsYesterday = 0, followers, followersDelta, recipes = [], stagnant = false }) {
  const lines = [];
  for (const c of armChanges.slice(0, 3)) {
    lines.push({ kind: 'learn',
      text: `${dimLabel(c.dimension)}「${c.arm}」の推定フォロー ${c.before.toFixed(2)}→${c.after.toFixed(2)}（n=${c.n}）`,
      evidence: JSON.stringify(c) });
  }
  if (conv != null && convBefore != null && Math.abs(conv - convBefore) > 0.01) {
    lines.push({ kind: 'learn', text: `転換率を ${convBefore.toFixed(2)}→${conv.toFixed(2)} に校正`, evidence: JSON.stringify({ conv, convBefore }) });
  }
  if (postsYesterday === 0) {
    const r = recipes.find((x) => x.rank === 1);
    lines.push({ kind: 'stagnate',
      text: r ? `投稿なし。明日はレシピ#1「${r.hook}×${r.pattern}×${slotLabel(r.slot)}」を投稿してください` : '投稿なし。候補を確認してください',
      evidence: JSON.stringify({ postsYesterday: 0 }) });
  }
  if (followers != null) {
    lines.push({ kind: 'learn', text: `フォロワー ${followers}人（前日比 ${followersDelta >= 0 ? '+' : ''}${followersDelta ?? 0}）`, evidence: JSON.stringify({ followers, followersDelta }) });
  }
  if (stagnant && lines.length === 0) {
    lines.push({ kind: 'stagnate', text: '腕の更新もレシピの変化もなし。投稿が足りないか計測が止まっている可能性', evidence: null });
  }
  return lines.map((l) => ({ ...l, date }));
}
const dimLabel = (d) => ({ pattern: '型', hook: 'フック', fact: '燃料', slot: '時間帯', format: '形式' }[d] || d);
export const slotLabel = (s) => ({ morning: '朝', noon: '昼', evening: '夜' }[s] || s);

// ── 日次不変条件 I1〜I7（指示書 §3）──
export function checkInvariants(state) {
  const i = {
    i1: state.metricsToday >= state.postsLast14d,
    i2: !!state.accountRowToday,
    i3: state.pendingFinalizations === 0,
    i4: state.armsUpdatedToday > 0,
    i5: state.recipesTomorrow === 3 && state.recipesConstraintOk === 3,
    i6: state.ledgerRowsToday >= 1,
    i7: state.convRecomputedToday,
  };
  const allOk = Object.values(i).every(Boolean);
  const failed = Object.entries(i).filter(([, v]) => !v).map(([k]) => k.toUpperCase());
  return { ...i, allOk, failed };
}
