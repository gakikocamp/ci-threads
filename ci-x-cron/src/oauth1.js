// OAuth 1.0a (HMAC-SHA1) 署名生成 — X API v2 のユーザーコンテキスト認証用。
// Cloudflare Workers ランタイムには crypto.subtle (WebCrypto) のみがあるため node:crypto は使わない。

// RFC3986 percent-encode。encodeURIComponent は !*'() を残すため追加で置換する
export function percentEncode(str) {
  return encodeURIComponent(String(str)).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// OAuth仕様上ランダム値であればよいが、英数字のみに寄せて認証局側の実装差異を避ける
export function generateNonce(length = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

// key=value の配列を RFC3986 encode → key,value 双方でソート → '&' 結合
function buildParamString(params) {
  const encoded = params.map(([k, v]) => [percentEncode(k), percentEncode(v)]);
  encoded.sort(([k1, v1], [k2, v2]) => {
    if (k1 !== k2) return k1 < k2 ? -1 : 1;
    if (v1 !== v2) return v1 < v2 ? -1 : 1;
    return 0;
  });
  return encoded.map(([k, v]) => `${k}=${v}`).join('&');
}

// Signature Base String: METHOD & baseURL(query除く) & 全パラメータ(query+oauth+body)
function buildBaseString(method, url, params) {
  const u = new URL(url);
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const queryParams = [...u.searchParams.entries()];
  const paramString = buildParamString([...queryParams, ...params]);
  return `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(paramString)}`;
}

async function hmacSha1Base64(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// params: [[key, value], ...] — oauth_* と body/query パラメータをすべて含める（呼び出し側の責務）
export async function getOAuthSignature({ method, url, params = [], consumerSecret, tokenSecret = '' }) {
  const baseString = buildBaseString(method, url, params);
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return hmacSha1Base64(signingKey, baseString);
}

// Authorization: OAuth ... ヘッダの文字列を組み立てる。
// bodyParams は application/x-www-form-urlencoded のボディがある場合のみ渡す（X API v2 の GET では通常不要）
export async function buildAuthHeader({
  method,
  url,
  consumerKey,
  consumerSecret,
  token,
  tokenSecret,
  bodyParams = [],
  nonce,
  timestamp,
}) {
  const oauthEntries = [
    ['oauth_consumer_key', consumerKey],
    ['oauth_nonce', nonce || generateNonce()],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', timestamp || String(Math.floor(Date.now() / 1000))],
    ['oauth_token', token],
    ['oauth_version', '1.0'],
  ];

  const signature = await getOAuthSignature({
    method,
    url,
    params: [...oauthEntries, ...bodyParams],
    consumerSecret,
    tokenSecret,
  });

  const headerParams = [...oauthEntries, ['oauth_signature', signature]].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const headerStr = headerParams
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(', ');
  return `OAuth ${headerStr}`;
}
