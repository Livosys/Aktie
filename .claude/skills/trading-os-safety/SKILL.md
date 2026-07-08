---
name: trading-os-safety
description: Safety-reglerna för Trading OS — flaggor, env-gates, ordervägar, förbud. Läs FÖRE varje ändring som tangerar trading-vägar, execution, safety-flaggor, IBKR, order, broker, live-läge eller Mini Future.
---

# Trading OS Safety

Kanoniska dokument: `docs/TRADING_OS_SAFETY.md`, `docs/SAFETY_RULES.md`.

## Absoluta förbud (nu-läget)
Ingen live trading. Ingen broker. Ingen IBKR submit. Ingen riktig order. Ingen riktig Mini Future-order (kräver separat explicit mänskligt godkännande). Ingen push/commit/pm2 save/live-execution-ändring utan explicit order.

## Flaggor som alltid hålls
`mode=paper` (paper_only på paper-ytor), `live_trading_enabled=false`, `broker_enabled=false`, `actions_allowed=false`, `can_place_orders=false`.

## Var skyddet sitter
- `src/services/executionSafetyService.js`: avvisar `mode=live` (`live_not_allowed`) och `live_trading_enabled=true` (`live_trading_not_allowed_v1`); tvingar tillbaka paper; blockerar replay-exekvering; kill switch.
- `.env`: `IB_PAPER_SUBMIT_ROUTES_ENABLED=false` (submit-routes av). `IB_PAPER_EXECUTION_ENABLED=true` = IBKR **paper**-konto, inte live — larma inte på den.
- Autopiloter (`batchAutopilotService.js`, replay-scheduler): frysta SAFETY-objekt, exekvering oimplementerad/dry-run.

## Arbetsprocedur
1. Före ändring: `bash scripts/harness/safety_harness.sh` (exit 1 = stoppa).
2. Grep din egen diff efter: `placeOrder|submitOrder|live_trading_enabled|broker_enabled|actions_allowed|can_place_orders|mode.*live|SUBMIT.*true`.
3. Efter ändring + ev. `pm2 restart`: kör harness igen + `curl -s http://127.0.0.1:3001/api/safety/status` (måste visa `mode:"paper"`).
4. Farlig status upptäckt → avbryt, rapportera överst, ändra inget live-läge själv.

## Rapportkrav
Varje arbetsrapport bekräftar explicit: ingen live trading aktiverad, ingen broker, ingen order skickad, ingen IBKR submit-väg rörd, ingen Mini Future real-money-väg skapad.
