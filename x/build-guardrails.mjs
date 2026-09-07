#!/usr/bin/env node
// guardrails/*.json → x/guardrails.compiled.js（ESM）に束ねる。
// JSONを直接importできない実行環境（Pages Functions / Workers / ブラウザ）でも同じ憲法を読めるようにする。
// 憲法ファイルを変えたら必ず実行: node x/build-guardrails.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (f) => JSON.parse(readFileSync(join(root, 'guardrails', f), 'utf8'));

const bundle = {
  factTable: read('fact-table.json'),
  ngWords: read('ng-words.json'),
  banTopics: read('ban-topics.json'),
  builtAt: new Date().toISOString(),
};

const out = `// 自動生成: node x/build-guardrails.mjs（手で編集しない。guardrails/*.json を直す）
export const GUARDRAILS = ${JSON.stringify(bundle, null, 2)};
export default GUARDRAILS;
`;
writeFileSync(join(here, 'guardrails.compiled.js'), out);
console.log('guardrails.compiled.js written', bundle.builtAt);
