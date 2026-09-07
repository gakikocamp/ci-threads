// 実行: node --test test/
// テストベクタは X(Twitter) 公式ドキュメント「Creating a signature」の例をそのまま使用
// https://developer.x.com/en/docs/authentication/oauth-1-0a/creating-a-signature
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentEncode, getOAuthSignature, buildAuthHeader } from '../src/oauth1.js';

test('percentEncode は RFC3986 予約文字を残さずエンコードする', () => {
  assert.equal(percentEncode('Ladies + Gentlemen'), 'Ladies%20%2B%20Gentlemen');
  assert.equal(percentEncode("!*'()"), '%21%2A%27%28%29');
  assert.equal(percentEncode('abc123-_.~'), 'abc123-_.~');
});

test('公式テストベクタ: statuses/update.json の署名が一致する', async () => {
  const sig = await getOAuthSignature({
    method: 'POST',
    url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
    params: [
      ['oauth_consumer_key', 'xvz1evFS4wEEPTGEFPHBog'],
      ['oauth_nonce', 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg'],
      ['oauth_signature_method', 'HMAC-SHA1'],
      ['oauth_timestamp', '1318622958'],
      ['oauth_token', '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb'],
      ['oauth_version', '1.0'],
      ['status', 'Hello Ladies + Gentlemen, a signed OAuth request!'],
    ],
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  });
  assert.equal(sig, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
});

test('buildAuthHeader: 同じnonce/timestampなら同じ署名を含むヘッダが生成される', async () => {
  const header = await buildAuthHeader({
    method: 'POST',
    url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    bodyParams: [['status', 'Hello Ladies + Gentlemen, a signed OAuth request!']],
    nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    timestamp: '1318622958',
  });
  assert.ok(header.startsWith('OAuth '));
  assert.match(header, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
  assert.match(header, /oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog"/);
});

test('generateNonce相当のランダム性: 2回のヘッダで署名が変わる（nonce省略時）', async () => {
  const opts = {
    method: 'GET',
    url: 'https://api.x.com/2/users/me',
    consumerKey: 'k',
    consumerSecret: 's',
    token: 't',
    tokenSecret: 'ts',
  };
  const h1 = await buildAuthHeader(opts);
  const h2 = await buildAuthHeader(opts);
  assert.notEqual(h1, h2);
});
