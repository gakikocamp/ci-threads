// ci-x-cron: X API v2 の読み取り専用データを毎日D1に記録するCloudflare Worker
// 投稿・いいね・フォロー等の書き込みAPIは設計上一切呼ばない（xapi.js にも実装しない）
import { runSelf } from './jobs/self.js';
import { runMetrics } from './jobs/metrics.js';
import { runPatterns } from './jobs/patterns.js';
import { runRadar } from './jobs/radar.js';
import { runLearn } from './jobs/learn.js';
import { logGuard, getSetting } from './util.js';

const JOBS = { self: runSelf, metrics: runMetrics, patterns: runPatterns, radar: runRadar, learn: runLearn };
// v3: 学習は計測のあと。radar は x_watchlist が空・radar_enabled=0 で常時スキップされる（他者監視は廃止）
const JOB_ORDER = ['self', 'metrics', 'patterns', 'learn', 'radar'];

// 各ジョブは独立してtry/catchする: 1つが失敗しても残りは実行し、失敗はguard_logに記録して次回cronに委ねる
async function runAll(env, names = JOB_ORDER) {
  const summary = {};
  for (const name of names) {
    const job = JOBS[name];
    if (!job) {
      summary[name] = { error: 'unknown job' };
      continue;
    }
    try {
      summary[name] = await job(env);
    } catch (err) {
      summary[name] = { error: String(err?.message || err) };
      await logGuard(env, 'worker', name, 'error', String(err?.stack || err));
    }
  }
  return summary;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAll(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      const phase = (await getSetting(env, 'phase')) || 'A';
      const paused = (await getSetting(env, 'paused')) || '0';
      return Response.json({ ok: true, phase, paused });
    }

    // x_settings.paused='1' でも計測(このWorker)は止めない。配信停止は別Workerの責務
    if (url.pathname === '/run' && request.method === 'POST') {
      const token = request.headers.get('x-cron-token');
      if (!env.X_CRON_TOKEN || token !== env.X_CRON_TOKEN) {
        return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
      }
      const job = url.searchParams.get('job') || 'all';
      const names = job === 'all' ? JOB_ORDER : [job];
      if (job !== 'all' && !JOBS[job]) {
        return Response.json({ ok: false, error: `unknown job: ${job}` }, { status: 400 });
      }
      const summary = await runAll(env, names);
      return Response.json({ ok: true, summary });
    }

    return new Response('not found', { status: 404 });
  },
};
