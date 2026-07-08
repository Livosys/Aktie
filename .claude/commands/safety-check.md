---
description: Full safety-revision — flaggor, env-gates, ordervägar (read-only, exit vid farlig status)
---

Kör en full safety-revision enligt docs/TRADING_OS_SAFETY.md. Allt read-only.

1. `bash scripts/harness/safety_harness.sh` — bifoga output.
2. `curl -s http://127.0.0.1:3001/api/safety/status` — verifiera: `mode:"paper"`, `live_trading_enabled:false`, `manual_armed:false`, `kill_switch_active:false`.
3. `grep -iE "SUBMIT|LIVE|BROKER" .env` (läs enbart) — verifiera `IB_PAPER_SUBMIT_ROUTES_ENABLED=false`; inga `*=true` för live/broker/submit-gates (obs: `IB_PAPER_EXECUTION_ENABLED=true` avser IBKR paper-konto och är OK).
4. Sök nya farliga mönster i ocommittad kod: `git diff` + `git status --short`, grep efter `placeOrder|submitOrder|live_trading_enabled\s*[:=]\s*true|broker_enabled\s*[:=]\s*true|actions_allowed\s*[:=]\s*true|can_place_orders\s*[:=]\s*true|mode\s*[:=]\s*['"]live`.
5. Verifiera att `src/services/executionSafetyService.js` fortfarande avvisar `mode=live` (`live_not_allowed`) och `live_trading_enabled=true` (`live_trading_not_allowed_v1`).

Rapportera PASS/FAIL per punkt, farliga fynd överst med fil:rad. Om något är farligt: rekommendera åtgärd men ÄNDRA INGET utan explicit order. Ingen commit/push/pm2 save.
