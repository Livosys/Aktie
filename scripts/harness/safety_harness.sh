#!/usr/bin/env bash
# safety_harness.sh — read-only safety-revision för Trading OS.
# FÅR: läsa status, curl GET, kontrollera flaggor. FÅR INTE: ändra något.
# Exit 1 vid farlig status eller om safety inte kan verifieras (fail-closed).
set -u
BASE="http://127.0.0.1:3001/api"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
warn() { echo "WARN  $1"; }

echo "=== SAFETY HARNESS $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# 1. Safety-status från API (fail-closed om servern inte svarar)
STATUS="$(curl -s --max-time 10 "$BASE/safety/status" || true)"
if [ -z "$STATUS" ]; then
  fail "kunde inte nå $BASE/safety/status — safety kan inte verifieras (fail-closed)"
else
  echo "$STATUS" | grep -q '"mode":"paper"' \
    && pass "mode=paper" || fail "mode är INTE paper: $(echo "$STATUS" | head -c 200)"
  echo "$STATUS" | grep -q '"live_trading_enabled":false' \
    && pass "live_trading_enabled=false" || fail "live_trading_enabled är INTE false"
  echo "$STATUS" | grep -q '"manual_armed":false' \
    && pass "manual_armed=false" || fail "manual_armed är INTE false"
  if echo "$STATUS" | grep -q '"kill_switch_active":true'; then
    warn "kill switch är AKTIV (blockerar trading — säkert men avvikande läge)"
  else
    pass "kill_switch_active=false"
  fi
fi

# 2. Env-gates (read-only). IB_PAPER_EXECUTION_ENABLED=true = IBKR paper-konto, OK.
ENVFILE="$ROOT/.env"
if [ -f "$ENVFILE" ]; then
  if grep -Eq '^\s*IB_PAPER_SUBMIT_ROUTES_ENABLED\s*=\s*true' "$ENVFILE"; then
    fail ".env: IB_PAPER_SUBMIT_ROUTES_ENABLED=true (submit-routes ÖPPNA)"
  else
    pass ".env: IB_PAPER_SUBMIT_ROUTES_ENABLED är inte true"
  fi
  DANGER="$(grep -EIn '^\s*(LIVE_TRADING[A-Z_]*|BROKER_ENABLED|[A-Z_]*SUBMIT[A-Z_]*ENABLED|ACTIONS_ALLOWED|CAN_PLACE_ORDERS)\s*=\s*true' "$ENVFILE" | grep -v 'IB_PAPER_EXECUTION_ENABLED' || true)"
  if [ -n "$DANGER" ]; then fail ".env farliga gates satta till true:"$'\n'"$DANGER"; else pass ".env: inga live/broker/submit-gates = true"; fi
else
  warn ".env saknas — env-gates kunde inte kontrolleras"
fi

# 3. Hårdkodat skydd finns kvar i executionSafetyService
ESS="$ROOT/src/services/executionSafetyService.js"
if [ -f "$ESS" ] && grep -q "live_not_allowed" "$ESS" && grep -q "live_trading_not_allowed_v1" "$ESS"; then
  pass "executionSafetyService avvisar fortfarande mode=live och live_trading_enabled=true"
else
  fail "executionSafetyService-skyddet kunde inte verifieras ($ESS)"
fi

echo "---"
if [ "$FAIL" -eq 0 ]; then echo "RESULTAT: PASS (ingen farlig status)"; exit 0; else echo "RESULTAT: FAIL — FARLIG/OVERIFIERAD STATUS, se ovan"; exit 1; fi
