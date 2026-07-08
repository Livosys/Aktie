#!/usr/bin/env bash
# batch_replay_harness.sh — read-only koll av batch- och replay-systemet.
# Exit 1 vid FAIL eller farlig autopilot-konfiguration. Inga POST-anrop.
set -u
BASE="http://127.0.0.1:3001/api"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
warn() { echo "WARN  $1"; }
get() { curl -s --max-time 10 -o /dev/null -w "%{http_code}" "$BASE$1"; }

echo "=== BATCH/REPLAY HARNESS $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

for EP in /status/batches /status/replay /strategy-batches /replay/sessions /replay/runs; do
  CODE="$(get "$EP" 2>/dev/null)" || CODE="000"
  [ "$CODE" = "200" ] && pass "GET $EP → 200" || fail "GET $EP → $CODE"
done

# Autopilot-gates: enabled utan dry-run = farligt
for EP in /status/batch-autopilot /status/replay-autopilot; do
  BODY="$(curl -s --max-time 10 "$BASE$EP" || true)"
  if [ -z "$BODY" ]; then
    warn "GET $EP gav tomt svar (autopilot-status okänd)"
    continue
  fi
  if echo "$BODY" | grep -q '"enabled":true'; then
    if echo "$BODY" | grep -Eq '"dryRunOnly":false|"dry_run_only":false'; then
      fail "$EP: autopilot enabled UTAN dry-run-only — farlig konfiguration"
    else
      warn "$EP: autopilot enabled (dry-run) — verifiera att det är avsiktligt"
    fi
  else
    pass "$EP: autopilot avstängd eller dry-run (säkert läge)"
  fi
done

echo "---"
if [ "$FAIL" -eq 0 ]; then echo "RESULTAT: PASS"; exit 0; else echo "RESULTAT: FAIL"; exit 1; fi
