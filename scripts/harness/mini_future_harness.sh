#!/usr/bin/env bash
# mini_future_harness.sh — read-only koll att Mini Future är i research/paper-fas utan ordervägar. Exit 1 vid FAIL.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
warn() { echo "WARN  $1"; }

echo "=== MINI FUTURE HARNESS $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# Dokumentation + real-money-regeln
if [ -f "$ROOT/docs/MINI_FUTURE_RESEARCH.md" ]; then
  pass "docs/MINI_FUTURE_RESEARCH.md finns"
  grep -q "separate explicit human approval" "$ROOT/docs/MINI_FUTURE_RESEARCH.md" \
    && pass "real-money-regeln dokumenterad (separate explicit human approval)" \
    || fail "real-money-regeln saknas i MINI_FUTURE_RESEARCH.md"
else
  fail "docs/MINI_FUTURE_RESEARCH.md saknas"
fi

# Inga ordervägar i mini-future-specifik kod
MF_FILES="$(grep -rliE "miniFuture|mini-future|mini_future" "$ROOT/src" "$ROOT/client/src" --include="*.js" --include="*.jsx" 2>/dev/null | grep -iE "minifuture|mini-future|mini_future" || true)"
if [ -z "$MF_FILES" ]; then
  echo "INFO  ingen dedikerad mini-future-kod ännu (fas R1 — endast docs)"
  pass "inga mini-future-ordervägar (ingen mini-future-kod existerar)"
else
  BAD=0
  while IFS= read -r F; do
    if grep -nE "placeOrder|submitOrder|POST.*order" "$F" >/dev/null 2>&1; then
      fail "möjlig orderväg i mini-future-fil: $F"
      BAD=1
    fi
  done <<< "$MF_FILES"
  [ "$BAD" -eq 0 ] && pass "mini-future-filer utan ordervägar"
fi

# Global safety måste vara paper
STATUS="$(curl -s --max-time 10 http://127.0.0.1:3001/api/safety/status || true)"
if [ -n "$STATUS" ] && echo "$STATUS" | grep -q '"mode":"paper"'; then
  pass "global safety mode=paper"
else
  fail "global safety kunde inte verifieras som paper"
fi

echo "---"
if [ "$FAIL" -eq 0 ]; then echo "RESULTAT: PASS (Mini Future = research/paper, real-money disabled)"; exit 0; else echo "RESULTAT: FAIL"; exit 1; fi
