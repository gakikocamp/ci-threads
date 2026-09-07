// 実行: npm test（node --test test/）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRng, sampleNormal, welfordAdd, welfordRemove, computeConv, attributeDirect,
  computeObservation, posterior, sampleArm, checkConstraints, buildRecipes,
  buildLedger, checkInvariants, daysBetween, DEAD_PATTERNS,
} from '../src/learn-core.js';

// ── 決定的乱数（冪等性の要）──
test('同じシードなら同じ列。違うシードなら違う列', () => {
  const a = [...Array(5)].map(makeRng('2026-09-08'));
  const r1 = makeRng('2026-09-08'), r2 = makeRng('2026-09-08'), r3 = makeRng('2026-09-09');
  const s1 = [r1(), r1(), r1()], s2 = [r2(), r2(), r2()], s3 = [r3(), r3(), r3()];
  assert.deepEqual(s1, s2);
  assert.notDeepEqual(s1, s3);
  assert.ok(s1.every((x) => x >= 0 && x < 1));
  assert.equal(a.length, 5);
});
test('sampleNormal はおおよそ mu 中心', () => {
  const rng = makeRng(42);
  const xs = [...Array(2000)].map(() => sampleNormal(rng, 5, 1));
  const mean = xs.reduce((a, b) => a + b) / xs.length;
  assert.ok(Math.abs(mean - 5) < 0.15, `mean=${mean}`);
});

// ── Welford ──
test('welfordAdd は逐次平均・分散を正しく出す', () => {
  let s = { n: 0, mean: 0, m2: 0 };
  for (const x of [2, 4, 4, 4, 5, 5, 7, 9]) s = welfordAdd(s, x);
  assert.equal(s.n, 8);
  assert.equal(s.mean, 5);
  assert.ok(Math.abs(s.m2 / (s.n - 1) - 4.571) < 0.01);
});
test('welfordRemove は add を打ち消す（仮反映→確定の入れ替え）', () => {
  let s = { n: 0, mean: 0, m2: 0 };
  for (const x of [1, 3, 5]) s = welfordAdd(s, x);
  const before = { ...s };
  s = welfordAdd(s, 99);
  s = welfordRemove(s, 99);
  assert.equal(s.n, before.n);
  assert.ok(Math.abs(s.mean - before.mean) < 1e-9);
  assert.ok(Math.abs(s.m2 - before.m2) < 1e-6);
});

// ── 転換率 ──
test('computeConv: 分母不足なら既定0.3、範囲外はクランプ', () => {
  assert.equal(computeConv(10, 20), 0.3);
  assert.equal(computeConv(30, 100), 0.3);
  assert.equal(computeConv(60, 100), 0.6);
  assert.equal(computeConv(200, 100), 0.6);
  assert.equal(computeConv(0, 100), 0.05);
});

// ── 帰属 ──
test('attributeDirect: フォロワー増分をインプ按分し、総和が増分を超えない', () => {
  const out = attributeDirect({
    dailyDeltas: { '2026-09-01': 10, '2026-09-02': -3, '2026-09-03': 6 },
    dailyImpressions: {
      '2026-09-01': { a: 300, b: 100 },
      '2026-09-02': { a: 50 },
      '2026-09-03': { b: 200, c: 200 },
    },
  });
  assert.ok(Math.abs(out.a - 7.5) < 1e-9);   // 10 × 300/400
  assert.ok(Math.abs(out.b - (2.5 + 3)) < 1e-9);
  assert.ok(Math.abs(out.c - 3) < 1e-9);
  const total = Object.values(out).reduce((x, y) => x + y, 0);
  assert.ok(total <= 10 + 6 + 1e-9, `総和 ${total} が純増16を超えない（負の日は0扱い）`);
});
test('attributeDirect: インプ0の日は配らない（ゼロ除算しない）', () => {
  const out = attributeDirect({ dailyDeltas: { '2026-09-01': 5 }, dailyImpressions: { '2026-09-01': {} } });
  assert.deepEqual(out, {});
});

test('computeObservation: clicksとdirectを半々で混ぜる', () => {
  const o = computeObservation({ profileClicks: 100, conv: 0.3, direct: 10, replies: 2, quotes: 1, reposts: 3, likes: 20, bookmarks: 4 });
  assert.equal(o.est_follows_clicks, 30);
  assert.equal(o.est_follows_direct, 10);
  assert.equal(o.est_follows, 20);
  assert.equal(o.engagement_score, 5 * 2 + 5 * 1 + 3 + 10 + 8);
});

// ── 事後分布 ──
test('posterior: 観測が無ければpriorに一致し、増えるほど実測に寄る', () => {
  const p0 = posterior({ n: 0, mean: 0, m2: 0, prior_mean: 1.6, prior_n: 2 }, 1);
  assert.ok(Math.abs(p0.mu - 1.6) < 1e-9);
  const p1 = posterior({ n: 20, mean: 0.5, m2: 5, prior_mean: 1.6, prior_n: 2 }, 1);
  assert.ok(p1.mu < 0.7, `mu=${p1.mu} は実測0.5に寄る`);
  assert.ok(p1.sigma < p0.sigma, 'データが増えると不確実性が減る');
});
test('sampleArm: 明らかに強い腕が多数回で選ばれる', () => {
  const rng = makeRng(7);
  const arms = [
    { arm: '強', n: 30, mean: 5, m2: 3, prior_mean: 5, prior_n: 2 },
    { arm: '弱', n: 30, mean: 0.2, m2: 3, prior_mean: 0.2, prior_n: 2 },
  ];
  let strong = 0;
  for (let i = 0; i < 200; i++) if (sampleArm(rng, arms, 1).arm === '強') strong++;
  assert.ok(strong > 180, `強い腕が ${strong}/200`);
});

// ── 制約 ──
const baseCtx = { today: '2026-09-10', factLastUsed: {}, countsThisWeek: {}, countsThisMonth: {}, yesterdayPattern: null, mode: 'buzz' };
test('制約: 同型2日連続・数字絶滅週1・お礼月1・死に型', () => {
  assert.equal(checkConstraints({ pattern: 'A', fact_ids: [] }, { ...baseCtx, yesterdayPattern: 'A' }).ok, false);
  assert.equal(checkConstraints({ pattern: '数字絶滅型', fact_ids: [] }, { ...baseCtx, countsThisWeek: { 数字絶滅型: 1 } }).ok, false);
  assert.equal(checkConstraints({ pattern: 'お礼', fact_ids: [] }, { ...baseCtx, countsThisMonth: { お礼: 1 } }).ok, false);
  for (const p of DEAD_PATTERNS) assert.equal(checkConstraints({ pattern: p, fact_ids: [] }, baseCtx).ok, false, p);
});
test('制約: 燃料は14日休ませる（13日はNG・14日はOK）', () => {
  assert.equal(checkConstraints({ pattern: 'A', fact_ids: ['f1'] }, { ...baseCtx, factLastUsed: { f1: '2026-08-28' } }).ok, false);
  assert.equal(checkConstraints({ pattern: 'A', fact_ids: ['f1'] }, { ...baseCtx, factLastUsed: { f1: '2026-08-27' } }).ok, true);
  assert.equal(daysBetween('2026-08-27', '2026-09-10'), 14);
});
test('制約: 災害モードは安否と事実のみ・燃料なし', () => {
  const ctx = { ...baseCtx, mode: 'safety' };
  assert.equal(checkConstraints({ pattern: '問いかけ二択', fact_ids: [] }, ctx).ok, false);
  assert.equal(checkConstraints({ pattern: '安否と事実', fact_ids: ['f1'] }, ctx).ok, false);
  assert.equal(checkConstraints({ pattern: '安否と事実', fact_ids: [] }, ctx).ok, true);
});

// ── レシピ生成 ──
const armsByDim = {
  pattern: [
    { arm: '数字絶滅型', n: 3, mean: 3, m2: 2, prior_mean: 1.6, prior_n: 2, last_tried: '2026-09-09' },
    { arm: '問いかけ二択', n: 4, mean: 2.4, m2: 2, prior_mean: 1.2, prior_n: 2, last_tried: '2026-09-07' },
    { arm: '真実暴露型', n: 2, mean: 1.5, m2: 1, prior_mean: 1.1, prior_n: 2, last_tried: '2026-09-05' },
    { arm: '利他応援型', n: 0, mean: 0, m2: 0, prior_mean: 1.1, prior_n: 2, last_tried: null },
    { arm: '説明分析型', n: 0, mean: 0, m2: 0, prior_mean: 0.2, prior_n: 2, last_tried: null },
  ],
  hook: [
    { arm: '衝撃数字', n: 2, mean: 3, m2: 1, prior_mean: 1.4, prior_n: 2, last_tried: '2026-09-09' },
    { arm: '問いかけ', n: 3, mean: 2, m2: 1, prior_mean: 1.2, prior_n: 2, last_tried: '2026-09-08' },
  ],
  slot: [
    { arm: 'evening', n: 5, mean: 2.5, m2: 2, prior_mean: 1.1, prior_n: 2, last_tried: '2026-09-09' },
    { arm: 'morning', n: 4, mean: 1.2, m2: 1, prior_mean: 1.0, prior_n: 2, last_tried: '2026-09-08' },
  ],
  format: [{ arm: 'single', n: 6, mean: 2, m2: 2, prior_mean: 1.0, prior_n: 2, last_tried: '2026-09-09' }],
  fact: [
    { arm: 'waterwheel', n: 2, mean: 2, m2: 1, prior_mean: 1.2, prior_n: 2, last_tried: '2026-09-06' },
    { arm: 'fire-method', n: 1, mean: 1.5, m2: 0, prior_mean: 1.0, prior_n: 2, last_tried: '2026-08-20' },
  ],
};

test('レシピ: 3本・型が重複しない・制約を通る・#3は探索', () => {
  const r = buildRecipes({ date: '2026-09-10', armsByDim, ctx: baseCtx, globalMean: 1 });
  assert.equal(r.length, 3);
  assert.ok(r.every((x) => x.constraint_ok === 1), JSON.stringify(r.filter((x) => !x.constraint_ok)));
  assert.equal(new Set(r.map((x) => x.pattern)).size, 3, '型が3本とも異なる');
  assert.equal(r[2].is_exploration, 1);
  assert.ok(r.every((x) => !DEAD_PATTERNS.includes(x.pattern)), '死に型を選ばない');
  assert.ok(r.every((x) => x.fact_ids.length >= 1 && x.rationale));
});
test('レシピ: 同じ日なら何度作っても同じ（冪等。cronの再実行で結果が変わらない）', () => {
  const a = buildRecipes({ date: '2026-09-10', armsByDim, ctx: baseCtx, globalMean: 1 });
  const b = buildRecipes({ date: '2026-09-10', armsByDim, ctx: baseCtx, globalMean: 1 });
  assert.deepEqual(a, b);
});
test('レシピ: 腕が拮抗していれば日によって選択が変わる（探索が起きる）', () => {
  // 上の armsByDim は「数字絶滅型」が突出しているため日が変わっても同じ選択になり得る（それが正しい挙動）。
  // 拮抗した腕集合では日ごとに違う組合せが出ることを確認する。
  const flat = {
    pattern: ['A', 'B', 'C', 'D'].map((arm) => ({ arm, n: 2, mean: 1, m2: 1, prior_mean: 1, prior_n: 2, last_tried: '2026-09-01' })),
    hook: ['h1', 'h2', 'h3'].map((arm) => ({ arm, n: 2, mean: 1, m2: 1, prior_mean: 1, prior_n: 2 })),
    slot: ['morning', 'evening'].map((arm) => ({ arm, n: 2, mean: 1, m2: 1, prior_mean: 1, prior_n: 2 })),
    format: ['single', 'reply'].map((arm) => ({ arm, n: 2, mean: 1, m2: 1, prior_mean: 1, prior_n: 2 })),
    fact: ['f1', 'f2', 'f3'].map((arm) => ({ arm, n: 2, mean: 1, m2: 1, prior_mean: 1, prior_n: 2 })),
  };
  const days = ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14'];
  const sigs = days.map((d) => buildRecipes({ date: d, armsByDim: flat, ctx: baseCtx, globalMean: 1 })
    .map((r) => `${r.pattern}/${r.hook}/${r.slot}`).join('|'));
  assert.ok(new Set(sigs).size >= 3, `5日で${new Set(sigs).size}通り: ${sigs.join(' ')}`);
});
test('レシピ: 探索枠は試行の少ない型を選ぶ', () => {
  const r = buildRecipes({ date: '2026-09-12', armsByDim, ctx: baseCtx, globalMean: 1 });
  assert.equal(r[2].pattern, '利他応援型', 'n=0の型が探索に選ばれる');
});
test('レシピ: 探索が足りない週は#1も探索になる', () => {
  const r = buildRecipes({ date: '2026-09-13', armsByDim, ctx: baseCtx, globalMean: 1, explorationDeficit: 2 });
  assert.equal(r[0].is_exploration, 1);
});
test('レシピ: 昨日の型は避ける', () => {
  const r = buildRecipes({ date: '2026-09-14', armsByDim, ctx: { ...baseCtx, yesterdayPattern: '数字絶滅型' }, globalMean: 1 });
  assert.ok(r.filter((x) => x.constraint_ok).every((x) => x.pattern !== '数字絶滅型'));
});
test('レシピ: 制約で作れない時は constraint_ok=0 で理由を残す（黙って壊れない）', () => {
  const onlyDead = { ...armsByDim, pattern: [{ arm: '説明分析型', n: 0, mean: 0, m2: 0, prior_mean: 0.2, prior_n: 2 }] };
  const r = buildRecipes({ date: '2026-09-15', armsByDim: onlyDead, ctx: baseCtx, globalMean: 1 });
  assert.ok(r.every((x) => x.constraint_ok === 0));
  assert.ok(r.every((x) => typeof x.rationale === 'string' && x.rationale.length > 0));
});

// ── 台帳 ──
test('台帳: 学びが日本語で出る。投稿0の日は次の一手を書く', () => {
  const lines = buildLedger({
    date: '2026-09-10',
    armChanges: [{ dimension: 'pattern', arm: '問いかけ二択', before: 1.8, after: 2.4, n: 4 }],
    conv: 0.22, convBefore: 0.3, postsYesterday: 0, followers: 120, followersDelta: 5,
    recipes: [{ rank: 1, pattern: '真実暴露型', hook: '秘密予告', slot: 'evening' }],
  });
  assert.ok(lines.length >= 3);
  assert.ok(lines.some((l) => l.text.includes('問いかけ二択') && l.text.includes('2.40')));
  assert.ok(lines.some((l) => l.kind === 'stagnate' && l.text.includes('レシピ#1')));
  assert.ok(lines.every((l) => l.date === '2026-09-10'));
});

// ── 不変条件 ──
test('不変条件: 全て満たせば allOk、欠ければ失敗名が出る', () => {
  const good = { metricsToday: 5, postsLast14d: 5, accountRowToday: true, pendingFinalizations: 0, armsUpdatedToday: 3, recipesTomorrow: 3, recipesConstraintOk: 3, ledgerRowsToday: 2, convRecomputedToday: true };
  assert.equal(checkInvariants(good).allOk, true);
  const bad = checkInvariants({ ...good, ledgerRowsToday: 0, recipesConstraintOk: 2 });
  assert.equal(bad.allOk, false);
  assert.deepEqual(bad.failed.sort(), ['I5', 'I6']);
});

test('レシピ: 制約で弾かれた腕は再抽選の候補から外れる（無駄打ちしない）', () => {
  // 「数字絶滅型」が最強だが週上限に達しているケース。#2 が別の型で成立すること
  const ctx = { ...baseCtx, countsThisWeek: { 数字絶滅型: 1 } };
  const strong = {
    ...armsByDim,
    pattern: [
      { arm: '数字絶滅型', n: 10, mean: 9, m2: 2, prior_mean: 1.6, prior_n: 2, last_tried: '2026-09-09' },
      { arm: '問いかけ二択', n: 8, mean: 3, m2: 2, prior_mean: 1.2, prior_n: 2, last_tried: '2026-09-07' },
      { arm: '真実暴露型', n: 6, mean: 2, m2: 1, prior_mean: 1.1, prior_n: 2, last_tried: '2026-09-05' },
      { arm: '利他応援型', n: 0, mean: 0, m2: 0, prior_mean: 1.1, prior_n: 2, last_tried: null },
    ],
  };
  const r = buildRecipes({ date: '2026-09-20', armsByDim: strong, ctx, globalMean: 1 });
  assert.equal(r.length, 3);
  assert.ok(r.every((x) => x.constraint_ok === 1), JSON.stringify(r));
  assert.ok(r.every((x) => x.pattern !== '数字絶滅型'), '週上限の型は選ばれない');
});

test('レシピ: 燃料が14日以内に使用済みなら別の燃料に切り替わる', () => {
  const ctx = { ...baseCtx, factLastUsed: { waterwheel: '2026-09-08' } }; // 2日前=NG
  const r = buildRecipes({ date: '2026-09-10', armsByDim, ctx, globalMean: 1 });
  assert.ok(r.every((x) => x.constraint_ok === 1));
  assert.ok(r.every((x) => !x.fact_ids.includes('waterwheel')));
});

test('台帳: オリジナル投稿と返信の効率を1件あたりで比べる', () => {
  const lines = buildLedger({
    date: '2026-09-20', armChanges: [], conv: 0.3, convBefore: 0.3, postsYesterday: 2,
    followers: 500, followersDelta: 12, recipes: [],
    kinds: [
      { kind: 'original', n: 20, per_item: 1.5, est_follows: 30 },
      { kind: 'reply', n: 150, per_item: 0.4, est_follows: 60 },
    ],
  });
  const t = lines.map((l) => l.text).join(' ');
  assert.ok(t.includes('オリジナル20本') && t.includes('返信150件'), t);
  assert.ok(t.includes('オリジナル投稿のほうが効率が高い'), t);
});
test('台帳: 返信が効率で上回れば倍率つきで報告する', () => {
  const lines = buildLedger({
    date: '2026-09-20', armChanges: [], conv: 0.3, convBefore: 0.3, postsYesterday: 2,
    followers: 500, followersDelta: 12, recipes: [],
    kinds: [
      { kind: 'original', n: 10, per_item: 0.5, est_follows: 5 },
      { kind: 'reply', n: 100, per_item: 1.0, est_follows: 100 },
    ],
  });
  const t = lines.map((l) => l.text).join(' ');
  assert.ok(t.includes('返信のほうが効率が高い') && t.includes('2.0倍'), t);
});
test('台帳: データ不足なら断定せず、返信の実数だけ出す', () => {
  const lines = buildLedger({
    date: '2026-09-20', armChanges: [], conv: 0.3, convBefore: 0.3, postsYesterday: 0,
    followers: 100, followersDelta: 1, recipes: [{ rank: 1, pattern: 'A', hook: 'B', slot: 'evening' }],
    kinds: [{ kind: 'reply', n: 12, per_item: 0.2, est_follows: 2.4 }],
  });
  const t = lines.map((l) => l.text).join(' ');
  assert.ok(t.includes('返信12件') && t.includes('比較にはオリジナル3本以上'), t);
});
