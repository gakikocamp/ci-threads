#!/usr/bin/env node
// 憲法（guardrails/fact-inventory.json）の燃料強度と運用設定を D1 の x_settings に投入する。
// Worker はリポジトリのJSONを読めないため、設定テーブル経由で受け渡す。
// 憲法を編集したら再実行すること。
//   ローカル: node scripts/seed-settings.mjs --local
//   本番:     node scripts/seed-settings.mjs --remote   ※CEO承認後
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..', '..');           // threads-app/
const remote = process.argv.includes('--remote');
const flag = remote ? '--remote' : '--local';

const inv = JSON.parse(readFileSync(join(appRoot, 'guardrails', 'fact-inventory.json'), 'utf8'));
const strengths = Object.fromEntries(inv.facts.map((f) => [f.id, f.strength ?? 1.0]));

// 2026-09-08 調査に基づく既定値: 1日2投稿（朝・夜）、リプライは人が1日15件前後
const settings = {
  fact_strengths: JSON.stringify(strengths),
  fact_inventory_version: inv.version,
  cadence_per_day: '2',
  exploration_min_per_week: '2',
  radar_enabled: '0',
  slots: JSON.stringify({ morning: '07:30-08:30', evening: '19:30-21:00' }),
  reply_target_per_day: '15',
};

const sql = Object.entries(settings)
  .map(([k, v]) => `INSERT INTO x_settings (key, value, updated_at) VALUES ('${k}', '${v.replace(/'/g, "''")}', ${Date.now()}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`)
  .join('\n');

const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'ci_zukou', flag, '--command', sql], {
  cwd: appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(out.split('\n').filter((l) => /success|error|executed/i.test(l)).join('\n'));
console.log(`投入: 燃料${Object.keys(strengths).length}件 / 設定${Object.keys(settings).length}件 (${flag})`);
