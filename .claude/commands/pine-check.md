---
description: Kontrollera Pine Script-flödet — filer, webhook, strategyId-koppling, paritet (read-only)
---

Kontrollera Pine Script-flödet enligt docs/PINESCRIPT_WORKFLOW.md. Allt read-only — skicka inga webhook-anrop.

1. **Hitta Pine Script-filer:** `find pine -name "*.pine"` + `pine/strategies/*/CHANGELOG.md`. Om tomt: rapportera att inga pine-filer skrivits ännu (strukturen finns i `pine/`).
2. **Hitta webhook-flödet:** verifiera POST `/api/tradingview/webhook` i `src/routes/api.js` (grep) samt `tradingViewConnectorService.js`, `tradingViewPaperReplayPreviewService.js`; senaste preview-logg via `tradingViewPreviewLogService`-data om tillgänglig.
3. **strategyId/version:** för varje pine-fil, läs metadata-blocket — visa strategyId, pineVersion, backendLogicVersion. Filer utan komplett metadata = avvikelse.
4. **Frikopplings-kontroll:** verifiera att varje pine-fils strategyId finns i backend-katalogen (`daytradingStrategyCatalogService.js`). Pine-filer utan backend-motsvarighet = FRIKOPPLAD (måste fixas eller märkas engine_test).
5. **Paritet:** kolla CHANGELOG för DIVERGED-markeringar; lista vad som behöver paritetstestas via replay-preview.
6. `bash scripts/harness/pinescript_harness.sh` — PASS/FAIL.

Rapport: pine-inventering, webhook-status, frikopplade filer (ska vara 0), vad som behöver fixas. Inga POST-anrop, inga ändringar.
