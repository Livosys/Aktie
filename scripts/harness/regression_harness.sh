#!/usr/bin/env bash
# regression_harness.sh — kör hela den säkra harness-sviten. Exit 1 om någon del failar.
# Read-only: aktiverar inget, skickar inga order, ingen push/pm2 save/env-ändring.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
FAIL=0

echo "=== REGRESSION HARNESS $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo "--- git status (informativt, ändras ej) ---"
git -C "$ROOT" status --short || true
echo ""

for H in safety_harness.sh batch_replay_harness.sh paper_trading_harness.sh futures_paper_harness.sh agents_harness.sh pinescript_harness.sh mini_future_harness.sh; do
  echo "─── kör $H ───"
  if bash "$DIR/$H"; then
    echo ">>> $H: PASS"
  else
    echo ">>> $H: FAIL"
    FAIL=1
  fi
  echo ""
done

# Snabb enhetstest av safety-kärnan om testfil finns (read-only, tmp-baserad)
if [ -f "$ROOT/src/services/executionSafetyService.test.js" ]; then
  echo "─── node --test executionSafetyService.test.js ───"
  if (cd "$ROOT" && timeout 120 node --test src/services/executionSafetyService.test.js >/dev/null 2>&1); then
    echo ">>> executionSafetyService unit tests: PASS"
  else
    echo ">>> executionSafetyService unit tests: FAIL"
    FAIL=1
  fi
fi

echo "==="
if [ "$FAIL" -eq 0 ]; then echo "REGRESSION: PASS"; exit 0; else echo "REGRESSION: FAIL"; exit 1; fi
