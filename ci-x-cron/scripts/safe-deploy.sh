#!/bin/bash
# ci-x-cron の安全配置スクリプト（CEO承認のうえで実行する）
# 1) テスト合格 2) 秘密の混入なし 3) DRY_RUN 値を明示確認 → 配置 → /health 実機確認
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/4 テスト =="
npm test --silent

echo "== 2/4 秘密の混入チェック =="
if grep -rnE "(X_API_KEY|X_API_SECRET|X_ACCESS_TOKEN|X_ACCESS_SECRET|X_CRON_TOKEN) *= *['\"]?[A-Za-z0-9]{16,}" src wrangler.toml 2>/dev/null; then
  echo "NG: ソースに秘密らしき値が含まれています。中止"; exit 1
fi
if [ -f .dev.vars ] && git ls-files --error-unmatch .dev.vars >/dev/null 2>&1; then
  echo "NG: .dev.vars が git 管理下です。中止"; exit 1
fi
echo "ok"

echo "== 3/4 DRY_RUN 確認 =="
DRY=$(grep -E '^DRY_RUN' wrangler.toml | sed -E 's/.*"([01])".*/\1/')
echo "wrangler.toml の DRY_RUN = ${DRY:-unset}（1=X APIを呼ばない・ログのみ）"

echo "== 4/4 配置 =="
npx wrangler deploy

URL=$(npx wrangler deployments list 2>/dev/null | grep -oE 'https://[a-z0-9.-]+workers\.dev' | head -1 || true)
if [ -n "$URL" ]; then
  echo "health: $URL/health"
  curl -s "$URL/health" || true; echo
fi
