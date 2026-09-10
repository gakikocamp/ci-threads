// 実行: node --test test/
// D1/fetchに依存しない純粋関数のみをテストする（ジョブ本体はwrangler dev --test-scheduledで実地確認）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMetricRow,
  extractRadarPostRow,
  matchQueueToTweet,
  aggregatePatternStats,
  computeConversionRate,
  computeGrowth,
  rankByGrowth,
} from '../src/extract.js';

test('extractMetricRow: non_public_metrics優先、無ければorganic→publicにフォールバック', () => {
  const tweet = {
    id: 't1',
    text: 'こんにちは',
    created_at: '2026-09-01T00:00:00.000Z',
    public_metrics: { like_count: 5, reply_count: 1, retweet_count: 2, quote_count: 0, bookmark_count: 3, impression_count: 999 },
    non_public_metrics: { impression_count: 120, user_profile_clicks: 4, url_link_clicks: 1 },
  };
  const row = extractMetricRow(tweet, '2026-09-01', 1000);
  assert.equal(row.impressions, 120); // non_public優先
  assert.equal(row.likes, 5);
  assert.equal(row.bookmarks, 3);
  assert.equal(row.profile_clicks, 4);
  assert.equal(row.link_clicks, 1);
  assert.equal(row.reposts, 2);
  assert.equal(row.quotes, 0);
  assert.equal(row.fetched_at, 1000);
});

test('extractMetricRow: non_public_metricsが無い場合はpublic_metricsのimpressionsにフォールバック', () => {
  const tweet = {
    id: 't2',
    public_metrics: { like_count: 1, reply_count: 0, retweet_count: 0, quote_count: 0, bookmark_count: 0, impression_count: 50 },
  };
  const row = extractMetricRow(tweet, '2026-09-01');
  assert.equal(row.impressions, 50);
  assert.equal(row.profile_clicks, null);
});

test('extractRadarPostRow: attachments.media_keysがあればhas_media=1', () => {
  const withMedia = extractRadarPostRow(
    { id: 'r1', public_metrics: { like_count: 1 }, attachments: { media_keys: ['m1'] } },
    'shakunone'
  );
  assert.equal(withMedia.has_media, 1);
  const noMedia = extractRadarPostRow({ id: 'r2', public_metrics: {} }, 'shakunone');
  assert.equal(noMedia.has_media, 0);
});

test('matchQueueToTweet: 本文先頭30文字が一致するtweetを返す', () => {
  const body = 'これは30文字ちょうどで一致させるテスト用の本文サンプルです続き';
  const tweets = [{ id: 'x1', text: body + '追加テキスト' }];
  const hit = matchQueueToTweet(body, tweets);
  assert.equal(hit.id, 'x1');
});

test('matchQueueToTweet: 一致しなければnull', () => {
  assert.equal(matchQueueToTweet('一致しない本文', [{ id: 'x1', text: '全然違う内容の投稿' }]), null);
  assert.equal(matchQueueToTweet('', [{ id: 'x1', text: 'abc' }]), null);
});

test('aggregatePatternStats: 型ごとにn/平均値を集計する', () => {
  const rows = [
    { pattern: 'A', impressions: 100, replies: 2, quotes: 1, profile_clicks: 4 },
    { pattern: 'A', impressions: 200, replies: 0, quotes: 0, profile_clicks: 2 },
    { pattern: 'B', impressions: 50, replies: 1, quotes: 0, profile_clicks: 1 },
  ];
  const stats = aggregatePatternStats(rows);
  assert.equal(stats.A.n, 2);
  assert.equal(stats.A.avg_impressions, 150);
  assert.equal(stats.A.avg_profile_clicks, 3);
  assert.equal(stats.B.n, 1);
});

test('computeConversionRate: 分母0ならフォールバック値', () => {
  assert.equal(computeConversionRate(10, 0), 0.3);
  assert.equal(computeConversionRate(10, 50), 0.2);
});

test('computeGrowth: delta7/growth7を算出、nullは伝播', () => {
  assert.deepEqual(computeGrowth(110, 100), { delta7: 10, growth7: 0.1 });
  assert.deepEqual(computeGrowth(110, null), { delta7: null, growth7: null });
  assert.deepEqual(computeGrowth(110, 0), { delta7: 110, growth7: null }); // ゼロ割回避
});

test('rankByGrowth: growth7降順でrank付与、nullは最後尾', () => {
  const ranked = rankByGrowth([
    { handle: 'a', growth7: 0.05 },
    { handle: 'b', growth7: 0.2 },
    { handle: 'c', growth7: null },
    { handle: 'd', growth7: 0.1 },
  ]);
  assert.deepEqual(ranked.map((r) => r.handle), ['b', 'd', 'a', 'c']);
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3, 4]);
});

// 返信の判別（種類別の効率比較の土台）
test('classifyKind: 返信・自分へのスレッド・オリジナルを見分ける', async () => {
  const { classifyKind } = await import('../src/extract.js');
  assert.equal(classifyKind({ id: '1' }), 'original');
  assert.equal(classifyKind({ id: '2', referenced_tweets: [{ type: 'replied_to', id: '9' }], in_reply_to_user_id: '999' }), 'reply');
  // 自分のツリー（自分への返信）は連投なので original 扱い
  assert.equal(classifyKind({ id: '3', referenced_tweets: [{ type: 'replied_to', id: '2' }], in_reply_to_user_id: '111' }, '111'), 'original');
  // 引用は返信ではない
  assert.equal(classifyKind({ id: '4', referenced_tweets: [{ type: 'quoted', id: '9' }] }), 'original');
});
