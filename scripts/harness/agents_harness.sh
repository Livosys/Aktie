#!/usr/bin/env bash
# agents_harness.sh — read-only koll av de 9 agenterna. Exit 1 vid FAIL.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="http://127.0.0.1:3001/api"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
warn() { echo "WARN  $1"; }

echo "=== AGENTS HARNESS $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

AGENTS="strategy-research risk-exit pine-script paper-trading futures-paper mini-future market-regime learning-scoring system-safety-deployment"
for A in $AGENTS; do
  F="$ROOT/.claude/agents/$A.md"
  if [ -f "$F" ]; then
    if grep -q "får INTE" "$F"; then
      pass "agent $A: definition + förbudssektion finns"
    else
      fail "agent $A: saknar förbudssektion ('Du får INTE')"
    fi
  else
    fail "agent $A: definitionsfil saknas ($F)"
  fi
done

# Ingen agentfil får ge order-rättigheter
if grep -liE "can_place_orders.*true|live_trading_enabled.*true|placeOrder|submitOrder" "$ROOT/.claude/agents/"*.md 2>/dev/null | grep -q .; then
  # tillåt omnämnanden i förbuds-/grep-kontext: kräv manuell koll bara om mönstret ser ut som instruktion
  warn "agentfiler nämner order-mönster — verifiera att det endast är i förbud/grep-instruktioner"
fi

[ -f "$ROOT/AGENTS.md" ] && pass "AGENTS.md (generella regler) finns" || fail "AGENTS.md saknas"
[ -f "$ROOT/docs/AI_AGENTS.md" ] && pass "docs/AI_AGENTS.md finns" || fail "docs/AI_AGENTS.md saknas"

# Rapportkatalog (informativt)
for A in $AGENTS; do
  D="$ROOT/data/agent-reports/$A"
  if [ -d "$D" ] && [ -n "$(ls -A "$D" 2>/dev/null)" ]; then
    LATEST="$(ls -t "$D" | head -1)"
    echo "INFO  $A: senaste rapport $LATEST"
  else
    echo "INFO  $A: saknar data (inga rapporter ännu)"
  fi
done

CODE="$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "$BASE/agent/latest-analysis" 2>/dev/null)" || CODE="000"
[ "$CODE" = "200" ] && pass "GET /agent/latest-analysis → 200" || warn "GET /agent/latest-analysis → $CODE (backend-agentlager svarar inte 200)"

echo "---"
if [ "$FAIL" -eq 0 ]; then echo "RESULTAT: PASS"; exit 0; else echo "RESULTAT: FAIL"; exit 1; fi
