---
name: paper-trading-engine
description: Paper Trading-motorn — runtime, state, daily caps, test-separation, allowlist/runtime-ready-kedjan, kända fällor. Läs vid arbete med paper trading, paper-trades, allowlist eller paper-runtime.
---

# Paper Trading-motorn

## Komponenter
- Runtime: `src/services/paperTradingRuntimeService.js` (+ `paperTradingStatusService.js`, `paperTradingTruthService.js`); agent-state med daily caps.
- Endpoints: `/api/paper-trading/status`, `/runtime`, `/live-state`, `/api/status/paper-trading`; trades/signaler: `/api/daytrading/paper-trades|paper-signals|paper-strategy-diagnostics`.
- Allowlist/readiness: `paperAllowlistService` → matris → `strategyRuntimeConnectorService`; `/api/automation/paper-allowlist/config`. "Runtime ready" ≠ events — partial narrow-strategier kräver narrow-state-data.

## Regler
1. Paper-runtime är paper_only; start/stop endast på explicit order (Start/Stopp-panelen finns för testläget).
2. Daily caps: total 30 / narrow 10 / per-strategi 8 / per-narrow 5 — blockedReason-koder i state.
3. Test-separation: `engine_test`/curl/manual/`simulated_fallback` exkluderas ur score (truth-service). Blanda aldrig.
4. Ingen fallback för okända signaler (ef5afd1); signaler med `can_create_paper_trade=false` (t.ex. REGULAR_PULLBACK) får inte öppna trades (894af2e).
5. PnL visas som signedMoney — teckenfel har förekommit, verifiera vid PnL-arbete.

## Kända fällor
- State bor i `data/` — PM2-repoint utan state-migrering ger split-brain (enabled:false, fel HISTORICAL_DATA_ROOT).
- Saknad `market-config.json` → `MARKET_CONTROL_PAPER_DISABLED` för crypto.
- N²-parse av TRADES_FILE var prod-spin-orsaken (fixad 05a2412) — undvik omläsning av hela tradefilen per trade.

## Verifiering
`bash scripts/harness/paper_trading_harness.sh`; command `/paper-check`.
