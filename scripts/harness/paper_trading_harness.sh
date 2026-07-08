#!/usr/bin/env bash
# paper_trading_harness.sh — read-only koll av Paper Trading. Exit 1 vid FAIL/farlig status.
set -u
BASE="http://127.0.0.1:3001/api"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
warn() { echo "WARN  $1"; }

echo "=== PAPER TRADING HARNESS $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# OBS: /daytrading/paper-trades är stor (~1,3 MB) och kan ta >10 s — generös timeout.
for EP in /paper-trading/status /paper-trading/runtime /status/paper-trading /daytrading/paper-trades /automation/paper-allowlist/config; do
  CODE="$(curl -s --max-time 45 -o /dev/null -w "%{http_code}" "$BASE$EP" 2>/dev/null)" || CODE="000"
  [ "$CODE" = "200" ] && pass "GET $EP → 200" || fail "GET $EP → $CODE"
done

BODY="$(curl -s --max-time 10 "$BASE/paper-trading/status" || true)"
if [ -n "$BODY" ]; then
  if echo "$BODY" | grep -Eq '"mode":"live"|"live_trading_enabled":true'; then
    fail "paper-trading/status indikerar LIVE-läge — FARLIGT"
  else
    pass "paper-trading rapporterar inte live-läge"
  fi
  echo "$BODY" | grep -q '"enabled":true' && warn "paper-runtime är PÅ (testläge) — förväntat om testläget körs" || pass "paper-runtime rapporterar inte enabled:true (eller fältet saknas)"
else
  fail "tomt svar från /paper-trading/status"
fi

echo "---"
if [ "$FAIL" -eq 0 ]; then echo "RESULTAT: PASS"; exit 0; else echo "RESULTAT: FAIL"; exit 1; fi
