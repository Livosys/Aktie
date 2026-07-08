#!/usr/bin/env bash
# futures_paper_harness.sh — read-only koll av Futures Paper (MNQ/MES). Exit 1 vid FAIL/farlig status.
set -u
BASE="http://127.0.0.1:3001/api"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
warn() { echo "WARN  $1"; }

echo "=== FUTURES PAPER HARNESS $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

for EP in /futures-paper/runtime /futures-paper/account /futures-paper/positions /futures-paper/trades /futures-paper/scanner /futures-paper/candidates; do
  CODE="$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "$BASE$EP" 2>/dev/null)" || CODE="000"
  [ "$CODE" = "200" ] && pass "GET $EP → 200" || fail "GET $EP → $CODE"
done

BODY="$(curl -s --max-time 10 "$BASE/futures-paper/runtime" || true)"
if [ -n "$BODY" ]; then
  if echo "$BODY" | grep -Eq '"mode":"live"|"live_trading_enabled":true|"can_place_orders":true|"broker_enabled":true'; then
    fail "futures-paper/runtime indikerar live/order-läge — FARLIGT"
  else
    pass "futures-paper rapporterar inte live/order-läge"
  fi
else
  fail "tomt svar från /futures-paper/runtime"
fi

# IBKR submit-lås
if [ -f "$ROOT/.env" ]; then
  grep -Eq '^\s*IB_PAPER_SUBMIT_ROUTES_ENABLED\s*=\s*true' "$ROOT/.env" \
    && fail ".env: IB_PAPER_SUBMIT_ROUTES_ENABLED=true (submit ÖPPEN)" \
    || pass ".env: IBKR submit-routes låsta"
  grep -Eq '^\s*IB_FUTURES_SUBMIT_ROUTES_ENABLED\s*=\s*true' "$ROOT/.env" \
    && fail ".env: IB_FUTURES_SUBMIT_ROUTES_ENABLED=true (futures-submit ÖPPEN)" \
    || pass ".env: futures submit-gate inte satt till true"
else
  warn ".env saknas — submit-gates kunde inte kontrolleras"
fi

# Adapter (härkomst) ska finnas — Futures Paper får inte ha egen strategikälla
[ -f "$ROOT/src/services/futuresTradingOsSignalAdapterService.js" ] \
  && pass "Trading OS-adapter finns (futuresTradingOsSignalAdapterService.js)" \
  || warn "Trading OS-adapter saknas i src/services — härkomstkedjan kan inte verifieras"

echo "---"
if [ "$FAIL" -eq 0 ]; then echo "RESULTAT: PASS"; exit 0; else echo "RESULTAT: FAIL"; exit 1; fi
