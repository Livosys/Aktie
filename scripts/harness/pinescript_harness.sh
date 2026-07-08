#!/usr/bin/env bash
# pinescript_harness.sh — read-only koll av Pine Script-strukturen. Exit 1 vid FAIL. Inga webhook-anrop.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
warn() { echo "WARN  $1"; }

echo "=== PINESCRIPT HARNESS $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

[ -f "$ROOT/pine/README.md" ] && pass "pine/README.md finns" || fail "pine/README.md saknas"
[ -f "$ROOT/pine/templates/trading_os_strategy_template.pine" ] && pass "pine-template finns" || fail "pine/templates/trading_os_strategy_template.pine saknas"
[ -f "$ROOT/docs/PINESCRIPT_WORKFLOW.md" ] && pass "docs/PINESCRIPT_WORKFLOW.md finns" || fail "docs/PINESCRIPT_WORKFLOW.md saknas"

# Webhook-flödet finns i koden
grep -q "tradingview/webhook" "$ROOT/src/routes/api.js" \
  && pass "webhook-route /api/tradingview/webhook finns i src/routes/api.js" \
  || fail "webhook-route saknas i src/routes/api.js"

# Alla riktiga pine-filer måste ha strategyId-metadata (template undantagen)
PINES="$(find "$ROOT/pine/strategies" -name "*.pine" 2>/dev/null || true)"
if [ -z "$PINES" ]; then
  echo "INFO  inga pine-filer i pine/strategies ännu (struktur redo)"
else
  while IFS= read -r P; do
    if grep -q "strategyId" "$P" && grep -q "pineVersion" "$P" && grep -q "backendLogicVersion" "$P"; then
      pass "$(basename "$P"): metadata (strategyId/pineVersion/backendLogicVersion) finns"
    else
      fail "$(basename "$P"): saknar obligatorisk metadata — FRIKOPPLAD pine-fil"
    fi
  done <<< "$PINES"
fi

echo "---"
if [ "$FAIL" -eq 0 ]; then echo "RESULTAT: PASS"; exit 0; else echo "RESULTAT: FAIL"; exit 1; fi
