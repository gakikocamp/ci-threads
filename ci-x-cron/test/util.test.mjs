// 実行: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jstDateString, addDaysStr } from '../src/util.js';

test('jstDateString: UTC17:59はJST日付ではまだ前日の可能性がある境界を確認', () => {
  // 2026-09-06T18:00:00Z -> JST 2026-09-07T03:00:00 (cronの実行想定時刻)
  assert.equal(jstDateString(new Date('2026-09-06T18:00:00.000Z')), '2026-09-07');
  // UTC 14:59 -> JST 23:59 まだ同日
  assert.equal(jstDateString(new Date('2026-09-06T14:59:00.000Z')), '2026-09-06');
});

test('addDaysStr: 日付文字列の加減算（月またぎ）', () => {
  assert.equal(addDaysStr('2026-09-07', -7), '2026-08-31');
  assert.equal(addDaysStr('2026-01-01', -1), '2025-12-31');
  assert.equal(addDaysStr('2026-09-07', 0), '2026-09-07');
});
