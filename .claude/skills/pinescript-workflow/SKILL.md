---
name: pinescript-workflow
description: Pine Script/TradingView-flödet — katalogstruktur, obligatorisk metadata, webhook, paritetskontroll mot backend. Läs vid arbete med Pine Script, TradingView-alerts eller webhook-signaler.
---

# Pine Script-workflow

Kanoniskt dokument: `docs/PINESCRIPT_WORKFLOW.md`.

## Struktur
`pine/templates/trading_os_strategy_template.pine` (mall), `pine/strategies/<strategyId>/vN.pine` + `CHANGELOG.md`. Webhook: POST `/api/tradingview/webhook` (`src/routes/api.js`); services: `tradingViewConnectorService.js`, `tradingViewPaperReplayPreviewService.js`, `tradingViewPreviewLogService.js`. Kontrakt: `docs/TRADINGVIEW_PAPER_REPLAY_CONTRACT.md`.

## Obligatorisk metadata (fil + webhook-payload)
`strategyId`, `strategyName`, `pineVersion`, `backendLogicVersion`, `signalSource`, `timeframe`, `direction`, `entry`, `stopLoss`, `takeProfit`, `exitLogic`, `riskModel`.

## Regler
1. Ingen Pine-fil utan strategyId som finns i backend-katalogen (`daytradingStrategyCatalogService.js`) — Pine lever aldrig separat.
2. Payload utan/med okänt strategyId får aldrig skapa paper-trade; ingen fallback till annan strategi (fix ef5afd1 återinförs aldrig).
3. Testanrop märks `signalSource: "engine_test"`.
4. Paritet: samma historiska fönster i replay-preview; avvikelse > tolerans → märk `DIVERGED` i CHANGELOG, stoppa vägen till Paper Trading tills fixad.
5. Webhook triggar aldrig ordervägar — endast paper/preview.

## Verifiering
`bash scripts/harness/pinescript_harness.sh`; command `/pine-check`.
