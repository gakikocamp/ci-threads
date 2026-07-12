// 内部ファイル（スクリプト・設定・SQL等）を本番URLで配信しない保険
const BLOCKED = [
  /\.py$/i,
  /\.sql$/i,
  /\.toml$/i,
  /requirements\.txt$/i,
  /^\/\.github\//,
  /^\/\.wrangler\//,
];

export async function onRequest(context) {
  const path = new URL(context.request.url).pathname;
  if (BLOCKED.some(re => re.test(path))) {
    return new Response('Not Found', { status: 404 });
  }
  return context.next();
}
